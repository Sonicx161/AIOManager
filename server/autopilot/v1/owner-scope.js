// Owner predicate for statements addressed by rule id. Policy: a legacy owner-less row (NULL or '') is
// matched only by its own rule id, never through an owner; an unknown owner (undefined) adds nothing
// beyond the caller's id and account predicates.
export const ownerPredicate = (owner, index) => {
    if (owner === undefined) return ['', []]
    if (!owner) return [" AND COALESCE(owner_sync_user, '') = ''", []]
    return [` AND owner_sync_user = $${index}`, [owner]]
}
