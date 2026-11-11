// Local-calendar identity for day-dependent caches. A local day is not a
// function of an epoch timestamp alone: it depends on the runtime zone, and a
// zone switch can move any timestamp across a calendar day. Caches that store
// day-derived values (day keys, day counts, day-partitioned sort order, header
// today/yesterday sums) must treat this token as part of their key and recheck
// it on every use.
//
// The zone name, not the current UTC offset, is the identity: two zones that
// share today's offset can still disagree on older timestamps.

export function localTimeZoneKey(): string {
    // Resolved on every call (~30us): memoizing across time would serve a
    // stale zone after a runtime TZ change, and day-derived caches would then
    // reuse wrong keys.
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}

/** Stable within one local calendar day; changes at local midnight or on a zone switch. */
export function localDayToken(now = Date.now()): string {
    return `${localTimeZoneKey()}|${new Date(now).toDateString()}`
}
