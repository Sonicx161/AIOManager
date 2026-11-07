import { hasSavedWatchState, matchesWatchPatch, sameWatchTitle, undatedRowCount } from './records.ts'
import { migrationFailure, migrationFailureMessage, WatchMigrationError } from './failures.ts'
import type { MigrationOptions, MigrationProgress, MigrationResult, MigrationRow, WatchMigrationPlan, WatchStateDestination, WatchStateRecord, WatchStateSnapshot, WatchStateSource } from './types.ts'

function isTransientMatchFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const candidate = error as { kind?: unknown; status?: unknown }
    return candidate.kind === 'server' || candidate.kind === 'network' || candidate.kind === 'timeout'
        || candidate.status === 429 || candidate.status === 503
}

export async function planWatchMigration(source: WatchStateSnapshot, destination: WatchStateDestination, options: MigrationOptions, signal: AbortSignal, progress?: MigrationProgress): Promise<WatchMigrationPlan> {
    if (source.scope === destination.scope) throw new Error('Choose a different remote user or server for the destination.')
    if (!options.watched && !options.resume) throw new Error('Choose watched titles, resume points, or both.')
    const identities = new Map<string, number>()
    for (const record of source.records) for (const id of record.identities) identities.set(id, (identities.get(id) || 0) + 1)
    const rows: MigrationRow[] = new Array(source.records.length)
    const controller = new AbortController()
    const matchingSignal = AbortSignal.any([signal, controller.signal])
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
            let matches: WatchStateRecord[]
            try {
                matches = await destination.resolve(record, matchingSignal)
            } catch (error) {
                // A facade can rate-limit or briefly lose upstream metadata while
                // matching a large source. Keep the preview useful and retryable:
                // one bad match must not discard every row already resolved.
                if (isTransientMatchFailure(error)) {
                    row.status = 'skipped'
                    row.reason = 'The destination temporarily limited matching for this title. Preview again to retry it.'
                    finish()
                    continue
                }
                throw error
            }
            matchingSignal.throwIfAborted()
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
    const finished = new Set(previous.filter(result => result.status === 'applied' || result.status === 'unchanged' || result.status === 'conflict').map(result => result.rowId))
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
        if (records?.length !== 1 || records[0].fingerprint !== row.source.fingerprint || !sameWatchTitle(row.source, records[0])) {
            result = { rowId: row.id, status: 'conflict', message: 'The source record changed or could not be verified. Preview again.', completedAt: Date.now() }
        } else {
            try {
                const written = await destination.apply(row.target!, row.patch!, signal)
                result = { rowId: row.id, status: written.status, message: written.message, completedAt: Date.now() }
                if (written.record && written.status !== 'conflict') {
                    const { watched, positionMs, playedAt, playCount } = written.record
                    result.verified = { watched, positionMs, playedAt, playCount }
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
    }
}

export function migrationReport(plan: WatchMigrationPlan, results: MigrationResult[]) {
    const byId = new Map(results.map(result => [result.rowId, result]))
    const undated = undatedRowCount(plan.rows)
    return {
        version: 1, createdAt: new Date(plan.createdAt).toISOString(), exportedAt: new Date().toISOString(),
        source: { label: plan.source.label, subject: plan.source.subject, complete: plan.source.complete, count: plan.source.records.length },
        destination: { label: plan.destination.label, subject: plan.destination.subject }, options: plan.options, notes: plan.notes,
        summary: { undated },
        rows: plan.rows.map(row => ({
            title: row.source.title, seriesTitle: row.source.seriesTitle, episodeTitle: row.source.episodeTitle, type: row.source.type, season: row.source.season, episode: row.source.episode, identities: row.source.identities,
            sourceItemId: row.source.id, destinationItemId: row.target?.id, sourceWatchDate: row.source.playedAt === null ? null : new Date(row.source.playedAt).toISOString(), dateConfidence: row.source.playedAt === null ? null : row.source.dateConfidence ?? 'exact', undated: row.undated === true,
            before: row.target ? { watched: row.target.watched, positionMs: row.target.positionMs, playedAt: row.target.playedAt, playCount: row.target.playCount } : null,
            requested: row.patch, previewStatus: row.status, reason: row.reason, notes: row.notes, result: byId.get(row.id),
        })),
    }
}
