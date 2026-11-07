// Pure dependency rules for removing a login that Autopilot rules still run on.
// Kept free of store and alias imports so node --test can exercise it directly.

export interface RemovalConnectionLike {
    id: string
    platform: string
    connectionType?: string | null
}

export interface RemovalAccountLike {
    id?: string
    connections?: ReadonlyArray<RemovalConnectionLike>
}

export interface RemovalRuleLike {
    id: string
    accountId: string
    name?: string
    isActive?: boolean
    platform?: string
    connectionId?: string
}

// A native Stremio login: a hydra-outbound connection tagged 'stremio' is a push
// target, never an authKey login, and must not count as one.
export const isStremioLogin = (connection: RemovalConnectionLike): boolean =>
    connection.platform === 'stremio' && (connection.connectionType == null || connection.connectionType === 'native')

export const stremioLoginsOf = (account: RemovalAccountLike | undefined): ReadonlyArray<RemovalConnectionLike> =>
    (account?.connections || []).filter(isStremioLogin)

// True when this removal takes the account's LAST Stremio login: the removed id is a
// native login and no other native login survives it.
export const isLastStremioLoginRemoval = (account: RemovalAccountLike | undefined, connectionId: string): boolean => {
    const logins = stremioLoginsOf(account)
    return logins.some(c => c.id === connectionId) && logins.every(c => c.id === connectionId)
}

// Rules that lose their login when this connection is removed: rules bound to it
// directly, plus, when it is the last Stremio login, the unbound canonical Stremio
// rules (no connectionId, no other platform). Matches resolveRuleSyncTarget targeting.
export function findDependentRules(rules: ReadonlyArray<RemovalRuleLike>, accountId: string, connectionId: string, account: RemovalAccountLike | undefined): RemovalRuleLike[] {
    const lastStremio = isLastStremioLoginRemoval(account, connectionId)
    return rules.filter(rule =>
        rule.accountId === accountId &&
        (rule.connectionId === connectionId ||
            (lastStremio && !rule.connectionId && (!rule.platform || rule.platform === 'stremio')))
    )
}

// Removing a login also deletes the Autopilot rules bound to it (and their history) from
// AIOManager; the confirm text must say so. Null when nothing bound to it is deleted.
export function boundRulesRemovalNotice(rules: ReadonlyArray<RemovalRuleLike>): string | null {
    if (rules.length === 0) return null
    const count = rules.length === 1 ? '1 Autopilot rule' : `${rules.length} Autopilot rules`
    const names = rules.map(r => r.name?.trim()).filter((n): n is string => !!n)
    const list = names.length > 0 && names.length <= 3 ? `: ${names.join(', ')}` : ''
    return `This also deletes ${count} for this login and ${rules.length === 1 ? 'its' : 'their'} history from AIOManager${list}.`
}
