import type { Account } from '@/types/account'
import { normalizedBackendUrl, normalizedLoginEmail } from './connection-identity.ts'
import { isRemovedConnection } from './connection-removals.ts'
import { resolveNuvioPushProfile } from './nuvio-profile-resolve.ts'
import { usesMainProfileAddons } from './nuvio-profile-flags.ts'

type Credentials = Record<string, string | undefined> | undefined

export interface NuvioRosterProfile {
    id?: unknown
    profile_index?: unknown
    profileIndex?: unknown
    uses_primary_addons?: unknown
}

export interface NuvioRoster {
    credentials: Credentials
    profiles: readonly NuvioRosterProfile[]
}

export interface NuvioProfileTarget {
    accountId?: string | null
    connectionId?: string | null
    credentials: Credentials
    profileMapping?: Record<string, number>
    activeProfileId?: string | null
}

export interface NuvioProfileSharer {
    id: string
    name: string
    email?: string
}

interface NuvioLogin {
    backend: string
    subject: string
    email: string
}

export function nuvioTokenSubject(accessToken: string | undefined): string {
    const part = (accessToken || '').split('.')[1]
    if (!part) return ''
    try {
        let payload = part.replace(/-/g, '+').replace(/_/g, '/')
        while (payload.length % 4) payload += '='
        const sub = (JSON.parse(atob(payload)) as { sub?: unknown }).sub
        return typeof sub === 'string' ? sub : ''
    } catch {
        return ''
    }
}

function loginOf(credentials: Credentials): NuvioLogin {
    return {
        backend: normalizedBackendUrl(credentials?.baseUrl),
        subject: nuvioTokenSubject(credentials?.accessToken),
        email: normalizedLoginEmail(credentials?.email),
    }
}

function sameLogin(a: NuvioLogin, b: NuvioLogin): boolean {
    if (a.backend !== b.backend) return false
    if (a.subject && b.subject) return a.subject === b.subject
    return !!a.email && a.email === b.email
}

function rosterIndex(row: NuvioRosterProfile): number {
    const value = Number(row.profile_index ?? row.profileIndex)
    return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function addonListKeys(target: NuvioProfileTarget, login: NuvioLogin, rosters: readonly NuvioRoster[]): Set<string> {
    const creds = target.credentials || {}
    const stored = String(resolveNuvioPushProfile({ credentials: creds, profileMapping: target.profileMapping }, target.activeProfileId) ?? '').trim()
    const fromCredentials = stored === String(creds.profileIndex || creds.profileId || '').trim()
    const candidates = [stored, ...(fromCredentials ? [creds.profileIndex, creds.profileId] : [])]
        .map(value => String(value ?? '').trim()).filter(Boolean)
    const rows = rosters.filter(roster => sameLogin(loginOf(roster.credentials), login)).flatMap(roster => roster.profiles)
    const mainRow = rows.find(item => rosterIndex(item) === 1)
    const keys = new Set<string>()
    const addMain = () => {
        keys.add('slot:1')
        if (mainRow?.id) keys.add(`id:${String(mainRow.id)}`)
    }
    if (candidates.length === 0) addMain()
    for (const value of candidates) {
        const numeric = /^\d+$/.test(value) ? parseInt(value, 10) : 0
        const row = numeric > 0
            ? rows.find(item => rosterIndex(item) === numeric)
            : rows.find(item => String(item.id ?? '') === value)
        if (row && usesMainProfileAddons(row)) { addMain(); continue }
        const index = numeric > 0 ? numeric : row ? rosterIndex(row) : 0
        if (index === 1) addMain()
        else if (index > 0) keys.add(`slot:${index}`)
        if (!numeric) keys.add(`id:${value}`)
        if (row?.id) keys.add(`id:${String(row.id)}`)
    }
    return keys
}

const overlaps = (a: Set<string>, b: Set<string>) => [...a].some(key => b.has(key))

export function findNuvioProfileSharers(
    accounts: readonly Account[],
    target: NuvioProfileTarget,
    options: { deletedAccounts?: Record<string, number>; rosters?: readonly NuvioRoster[] } = {},
): NuvioProfileSharer[] {
    const login = loginOf(target.credentials)
    if (!login.subject && !login.email) return []
    const rosters = options.rosters || []
    const keys = addonListKeys(target, login, rosters)
    const sharers: NuvioProfileSharer[] = []
    for (const account of accounts) {
        if (account.id === target.accountId) continue
        if (options.deletedAccounts && Object.hasOwn(options.deletedAccounts, account.id)) continue
        const shares = (account.connections || []).some(conn =>
            conn.platform === 'nuvio'
            && (conn.connectionType == null || conn.connectionType === 'native')
            && conn.id !== target.connectionId
            && !isRemovedConnection(conn.id, account)
            && sameLogin(loginOf(conn.credentials), login)
            && overlaps(addonListKeys({ credentials: conn.credentials, profileMapping: conn.profileMapping, activeProfileId: account.activeProfileId }, login, rosters), keys))
        if (shares) sharers.push({ id: account.id, name: account.name, email: account.email })
    }
    return sharers
}
