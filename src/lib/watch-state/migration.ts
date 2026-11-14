import { hasSavedWatchState, matchesWatchPatch, sameWatchTitle, undatedRowCount } from './records.ts'
import { migrationFailure, migrationFailureMessage, WatchMigrationError } from './failures.ts'
import { ratingFavoriteCounts } from './result-counts.ts'
import { globalMatchAbortError, isGlobalMatchFailure, matchFailureReason, repeatedMatchFailureMessage } from './error-messages.ts'
import { StaleChecksError } from './prewrite-fresh.ts'
import type { MigrationOptions, MigrationProgress, MigrationResult, MigrationRow, MigrationWriteResult, WatchMigrationPlan, WatchStateDestination, WatchStateRecord, WatchStateSnapshot, WatchStateSource } from './types.ts'

const REPEATED_MATCH_FAILURE_LIMIT = 3
const REPEATED_CONSECUTIVE_FAILURE_LIMIT = 10

// A row whose checks went stale was never written, so it restarts instead of failing.
const STALE_APPLY_RETRIES = 2
const STALE_CHECKS_MESSAGE = 'Paused too long to write safely. Preview again to import this title.'
const STALE_PARTIAL_MESSAGE = 'Paused too long to finish this title; only part of it was saved. Preview again to complete it.'

export async function planWatchMigration(source: WatchStateSnapshot, destination: WatchStateDestination, options: MigrationOptions, signal: AbortSignal, progress?: MigrationProgress): Promise<WatchMigrationPlan> {
    if (source.scope === destination.scope) throw new Error('Choose a different remote user or server for the destination.')
    if (!options.watched && !options.resume) throw new Error('Choose watched titles, resume points, or both.')
    const identities = new Map<string, number>()
    for (const record of source.records) for (const id of record.identities) identities.set(id, (identities.get(id) || 0) + 1)
    const rows: MigrationRow[] = new Array(source.records.length)
    const controller = new AbortController()
    const matchingSignal = AbortSignal.any([signal, controller.signal])
    const matchFailureCounts = new Map<string, number>()
    let respondedTitles = 0
    let repeatedReason: string | null = null
    let repeatedStreak = 0
    let next = 0
    let completed = 0
    const worker = async () => {
        while (next < source.records.length) {
            matchingSignal.throwIfAborted()
            const index = next++
            const record = source.records[index]
            const row: MigrationRow = { id: `${index}:${record.id}`, source: record, status: 'skipped', reason: '', notes: [...(record.notes || [])] }
            rows[index] = row
            const finish = () => {
                completed++
                if (completed % 25 === 0 || completed === source.records.length) progress?.(`Matching titles: ${completed.toLocaleString()} of ${source.records.length.toLocaleString()}`)
            }
            if (!record.identities.length || record.type === 'unknown') {
                row.reason = 'No verified movie or episode identifier. Title-only matching is not used.'
                finish()
                continue
            }
            if (record.identities.some(id => identities.get(id)! > 1)) {
                row.status = 'conflict'
                row.reason = 'The source contains more than one record for this title. Resolve the duplicate before importing.'
                finish()
                continue
            }
            const patch: NonNullable<MigrationRow['patch']> = {}
            const exactDates = record.dateConfidence !== 'estimated'
            const playedAt = exactDates ? record.playedAt : null
            const resumePlayedAt = record.resumePlayedAt === undefined ? undefined : exactDates ? record.resumePlayedAt : null
            const resumeDate = resumePlayedAt !== undefined ? resumePlayedAt : playedAt
            if (options.watched && record.watched === true) {
                if (destination.capabilities.requiresDates && playedAt === null) row.notes.push('This destination requires an original completion date. The undated watched flag cannot be copied.')
                else if (destination.capabilities.watched) patch.watched = true
                else row.notes.push('The destination cannot import watched flags.')
            }
            if (options.resume && typeof record.positionMs === 'number' && Number.isSafeInteger(record.positionMs) && record.positionMs > 0) {
                if (destination.capabilities.requiresDates && resumeDate === null) row.notes.push('This destination requires an original resume date. The undated resume point cannot be copied.')
                else if (destination.capabilities.requiresDuration && (!Number.isSafeInteger(record.durationMs) || record.durationMs! < record.positionMs)) row.notes.push('This destination requires a verified runtime for the resume point. No position will be copied without it.')
                else if (patch.watched && !destination.capabilities.combined) row.notes.push('Resume points on a watched title cannot be combined with its watched flag on this destination. Only the watched flag is selected.')
                else if (destination.capabilities.resume) {
                    patch.positionMs = record.positionMs
                    if (Number.isSafeInteger(record.durationMs) && record.durationMs! >= record.positionMs) patch.durationMs = record.durationMs
                }
                else row.notes.push('The destination cannot import resume points without reporting playback.')
            }
            if (record.favorite === true) {
                if (destination.capabilities.favorites) patch.favorite = true
                else row.notes.push('Favorites cannot be preserved by this destination.')
            }
            if (record.rating !== undefined) {
                if (destination.capabilities.ratings) patch.rating = record.rating
                else row.notes.push('Ratings cannot be preserved by this destination.')
            }
            if (!Object.keys(patch).length) {
                row.status = row.notes.length ? 'unsupported' : 'skipped'
                row.reason = row.notes.length ? 'The selected saved state is unsupported by this destination.' : 'No positive watched flag or resume point was selected.'
                finish()
                continue
            }
            const selectedDate = patch.watched ? playedAt : resumeDate
            if (selectedDate !== null && destination.capabilities.dates) patch.playedAt = selectedDate
            if (patch.positionMs !== undefined && destination.capabilities.dates && resumePlayedAt !== undefined) patch.resumePlayedAt = resumePlayedAt
            if (record.resumeSlot === true && destination.capabilities.dates) patch.resumeSlot = true
            if (selectedDate === null) row.undated = true
            if (!destination.capabilities.dates) row.notes.push('Original watch dates cannot be preserved by this destination.')
            else if (selectedDate === null) row.notes.push('The source has no exact watch date. No original date can be copied.')
            if (patch.watched && record.playCount !== undefined && record.playCount > 0) {
                if (destination.capabilities.counts && Number.isSafeInteger(record.playCount)) patch.playCount = record.playCount
                else row.notes.push('Historical play counts cannot be preserved by this destination.')
            }
            const refusal = await destination.preflight?.(record, patch, matchingSignal)
            if (refusal) {
                row.status = 'skipped'
                row.reason = refusal
                finish()
                continue
            }
            let matches: WatchStateRecord[]
            try {
                matches = await destination.resolve(record, matchingSignal)
            } catch (error) {
                matchingSignal.throwIfAborted()
                if (isGlobalMatchFailure(error)) throw globalMatchAbortError(error)
                const reason = matchFailureReason(error)
                const count = (matchFailureCounts.get(reason) ?? 0) + 1
                matchFailureCounts.set(reason, count)
                if (repeatedReason === reason) repeatedStreak++
                else {
                    repeatedReason = reason
                    repeatedStreak = 1
                }
                const allFailedSoFar = respondedTitles === 0 && count >= REPEATED_MATCH_FAILURE_LIMIT
                if (allFailedSoFar || repeatedStreak >= REPEATED_CONSECUTIVE_FAILURE_LIMIT) throw new Error(repeatedMatchFailureMessage(error))
                row.status = 'skipped'
                row.reason = reason
                finish()
                continue
            }
            matchingSignal.throwIfAborted()
            respondedTitles++
            repeatedReason = null
            repeatedStreak = 0
            const verified = matches.filter(item => sameWatchTitle(record, item))
            if (verified.length !== 1 || matches.length !== 1) {
                row.status = matches.length ? 'conflict' : 'skipped'
                const explanation = matches.length === 1 && matches[0].type === 'unknown' ? matches[0].notes?.[0] : undefined
                row.reason = explanation || (matches.length ? 'The destination match is ambiguous or its identifiers disagree.' : 'No matching title is available to this destination user.')
                row.notes.push(...matches.flatMap(match => match.notes || []))
                finish()
                continue
            }
            row.target = verified[0]
            row.patch = patch
            if (patch.rating !== undefined && row.target.rating !== undefined && row.target.rating !== patch.rating) {
                delete patch.rating
                row.notes.push('The destination already has a different rating for this title. Its rating was kept and the source rating was not copied.')
                if (!patch.watched && patch.positionMs === undefined && !patch.favorite) {
                    row.status = 'skipped'
                    row.reason = 'This destination already has a different rating for this title, which was kept.'
                    finish()
                    continue
                }
            }
            if (matchesWatchPatch(row.target, patch)) {
                row.status = 'unchanged'
                row.reason = 'The destination already has the selected state. Dates and counts will be kept.'
            } else if (hasSavedWatchState(row.target)) {
                row.status = 'conflict'
                row.reason = 'The destination already has watch state, or cannot prove it is empty. It will be kept.'
            } else {
                row.status = 'ready'
                row.reason = 'Verified title match. Add the selected state to this empty destination record.'
            }
            finish()
        }
    }
    try {
        await Promise.all(Array.from({ length: Math.min(4, source.records.length) }, worker))
    } catch (error) {
        controller.abort()
        throw error
    }
    signal.throwIfAborted()
    const targets = new Map<string, MigrationRow[]>()
    for (const row of rows) if (row.target) targets.set(row.target.id, [...(targets.get(row.target.id) || []), row])
    for (const duplicates of targets.values()) if (duplicates.length > 1) for (const row of duplicates) {
        row.status = 'conflict'
        row.reason = 'Multiple source records resolve to the same destination item. This item will be kept.'
    }
    for (const row of rows) row.notes = [...new Set(row.notes)]
    return {
        createdAt: Date.now(), source, destination: { connectionId: destination.connectionId, label: destination.label, subject: destination.subject, scope: destination.scope },
        options: { ...options }, rows,
        notes: [...new Set([...source.notes, ...destination.capabilities.notes, ...(!source.complete ? ['This source read is partial. Only the listed records can be imported; missing records never clear destination state.'] : [])])],
    }
}

export async function executeWatchMigration(plan: WatchMigrationPlan, source: WatchStateSource, destination: WatchStateDestination, selected: ReadonlySet<string>, previous: MigrationResult[], signal: AbortSignal, onResult: (result: MigrationResult) => void, progress?: MigrationProgress): Promise<void> {
    if (destination.scope !== plan.destination.scope || destination.connectionId !== plan.destination.connectionId) throw new Error('The destination changed. Preview again before importing.')
    const finished = new Set(previous.filter(result => result.status === 'applied' || result.status === 'unchanged' || result.status === 'conflict' || result.status === 'skipped').map(result => result.rowId))
    const rows = plan.rows.filter(row => row.status === 'ready' && row.target && row.patch && selected.has(row.id) && !finished.has(row.id))
    if (!rows.length) return
    progress?.('Verifying the source again…')
    const fresh = await source.read(signal, progress)
    signal.throwIfAborted()
    if (fresh.scope !== plan.source.scope || fresh.connectionId !== plan.source.connectionId) throw new Error('The source user or profile changed. Preview again before importing.')
    await destination.beginRun?.(signal)
    signal.throwIfAborted()
    const byId = new Map<string, typeof fresh.records>()
    for (const record of fresh.records) byId.set(record.id, [...(byId.get(record.id) || []), record])
    for (let index = 0; index < rows.length; index++) {
        signal.throwIfAborted()
        const row = rows[index]
        progress?.(`Importing and verifying: ${(index + 1).toLocaleString()} of ${rows.length.toLocaleString()}`)
        const records = byId.get(row.source.id)
        let result: MigrationResult
        let rowAuthExpired = false
        if (records?.length !== 1 || records[0].fingerprint !== row.source.fingerprint || !sameWatchTitle(row.source, records[0])) {
            result = { rowId: row.id, status: 'conflict', message: 'The source record changed or could not be verified. Preview again.', completedAt: Date.now() }
        } else {
            try {
                // A suspended tab can leave a row's checks older than the pre-write freshness
                // guard allows. Nothing was written, so the row restarts from a fresh read;
                // after the last retry it is kept as a conflict instead of failing.
                let written: MigrationWriteResult | null = null
                let partial = false
                for (let attempt = 0; ; attempt++) {
                    try {
                        written = await destination.apply(row.target!, row.patch!, signal)
                        break
                    } catch (error) {
                        if (!(error instanceof StaleChecksError)) throw error
                        partial ||= error.partial
                        if (attempt >= STALE_APPLY_RETRIES) {
                            // Part of the row may have landed, so it must read as needing review, not as never attempted.
                            if (!partial) written = { status: 'conflict', message: STALE_CHECKS_MESSAGE, stale: true }
                            break
                        }
                    }
                }
                result = written
                    ? { rowId: row.id, status: written.status, message: written.message, completedAt: Date.now(), ...(written.stale === true ? { stale: true } : {}), ...(written.dispatched === true ? { dispatched: true } : {}), ...(written.keptExisting === true ? { keptExisting: true } : {}), ...(written.ratingNotStored === true ? { ratingNotStored: true } : {}), ...(written.favoriteNotStored === true ? { favoriteNotStored: true } : {}) }
                    : { rowId: row.id, status: 'failed', message: STALE_PARTIAL_MESSAGE, failure: { stage: 'write', reason: 'unknown' }, completedAt: Date.now() }
                rowAuthExpired = written?.authExpired === true
                if (written?.record && written.status !== 'conflict') {
                    const { watched, positionMs, playedAt, playCount, rating, favorite } = written.record
                    result.verified = { watched, positionMs, playedAt, playCount, rating, favorite }
                }
            } catch (error) {
                if (signal.aborted) {
                    onResult({ rowId: row.id, status: 'failed', message: 'Stopped before readback completed. Preview again to check whether this item was saved.', completedAt: Date.now() })
                    signal.throwIfAborted()
                }
                const failure = migrationFailure(error)
                result = { rowId: row.id, status: 'failed', message: migrationFailureMessage(failure), failure, completedAt: Date.now() }
                onResult(result)
                if (error && typeof error === 'object' && 'kind' in error && error.kind === 'auth') throw new Error('The destination sign-in expired. Reconnect and preview again.')
                throw new WatchMigrationError(failure)
            }
        }
        onResult(result)
        // An optional rating/favorite write hit an expired sign-in after this row's
        // watched state was saved and verified. The result above stands; stop the run.
        if (rowAuthExpired) throw new Error('The destination sign-in expired. Reconnect and preview again.')
    }
}

export function migrationReport(plan: WatchMigrationPlan, results: MigrationResult[]) {
    const byId = new Map(results.map(result => [result.rowId, result]))
    const undated = undatedRowCount(plan.rows)
    const ratingFavorites = ratingFavoriteCounts(plan, results)
    return {
        version: 1, createdAt: new Date(plan.createdAt).toISOString(), exportedAt: new Date().toISOString(),
        source: { label: plan.source.label, subject: plan.source.subject, complete: plan.source.complete, count: plan.source.records.length },
        destination: { label: plan.destination.label, subject: plan.destination.subject }, options: plan.options, notes: plan.notes,
        summary: { undated, ratings: ratingFavorites.ratings.copied, favorites: ratingFavorites.favorites.copied },
        rows: plan.rows.map(row => ({
            title: row.source.title, seriesTitle: row.source.seriesTitle, episodeTitle: row.source.episodeTitle, type: row.source.type, season: row.source.season, episode: row.source.episode, identities: row.source.identities,
            sourceItemId: row.source.id, destinationItemId: row.target?.id, sourceWatchDate: row.source.playedAt === null ? null : new Date(row.source.playedAt).toISOString(), dateConfidence: row.source.playedAt === null ? null : row.source.dateConfidence ?? 'exact', undated: row.undated === true,
            before: row.target ? { watched: row.target.watched, positionMs: row.target.positionMs, playedAt: row.target.playedAt, playCount: row.target.playCount } : null,
            requested: row.patch, previewStatus: row.status, reason: row.reason, notes: row.notes, result: byId.get(row.id),
        })),
    }
}
