export const AUTO_RESTORE_GRACE_MS = 10 * 60_000

export interface CloudRuleSnapshot { ids: ReadonlySet<string>; at: number }

/** Tracks when each rule was first seen missing on the server; forgets rules that came back. */
export function trackMissingSince(missingSince: Map<string, number>, missingIds: Iterable<string>, now: number): void {
    const missing = new Set(missingIds)
    for (const id of [...missingSince.keys()]) if (!missing.has(id)) missingSince.delete(id)
    for (const id of missing) if (!missingSince.has(id)) missingSince.set(id, now)
}

/**
 * A rule missing on the server is restored only after it stayed missing for the grace
 * period and a cloud pull made since it went missing still carries it. A delete on
 * another device drops the rule from the cloud copy, so that delete wins.
 */
export function passesRestoreGate(id: string, missingSince: ReadonlyMap<string, number>, cloud: CloudRuleSnapshot | null, now: number): boolean {
    const since = missingSince.get(id)
    return since !== undefined && now - since >= AUTO_RESTORE_GRACE_MS && !!cloud && cloud.at > since && cloud.ids.has(id)
}
