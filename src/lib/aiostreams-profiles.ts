// AIOStreams keeps Jellyfin users in userData.profiles[] (owner id '') on nightly and in jellyfin.primary/personas on older servers; a nightly server drops the old fields when profiles exist.

export type AIOStreamsProfilesLayout = 'profiles' | 'legacy' | 'none'

type RecordValue = Record<string, unknown>

export interface AIOStreamsProfile {
    id: string
    owner: boolean
    name?: string
    avatar?: string
    variants?: string[]
    history?: 'own' | 'shared'
    trackers?: string[]
    hidden?: boolean
}

export const OWNER_PROFILE_ID = ''
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

const isRecord = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const isOwnerEntry = (entry: unknown) => isRecord(entry) && entry.id === OWNER_PROFILE_ID
const stringList = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined

export function profilesLayout(userData: unknown): AIOStreamsProfilesLayout {
    if (!isRecord(userData)) return 'none'
    if (Array.isArray(userData.profiles)) return 'profiles'
    const jellyfin = userData.jellyfin
    if (isRecord(jellyfin) && (isRecord(jellyfin.primary) || Array.isArray(jellyfin.personas))) return 'legacy'
    return 'none'
}

function normalise(entry: RecordValue, owner: boolean): AIOStreamsProfile {
    const profile: AIOStreamsProfile = { id: owner ? OWNER_PROFILE_ID : String(entry.id ?? ''), owner }
    if (typeof entry.name === 'string' && entry.name.trim()) profile.name = entry.name
    if (typeof entry.avatar === 'string' && /^https?:\/\//i.test(entry.avatar.trim())) profile.avatar = entry.avatar.trim()
    const variants = stringList(entry.variants)
    if (variants) profile.variants = variants
    if (entry.history === 'own' || entry.history === 'shared') profile.history = entry.history
    const trackers = stringList(entry.trackers)
    if (trackers) profile.trackers = trackers
    if (typeof entry.hidden === 'boolean') profile.hidden = entry.hidden
    return profile
}

export function listProfiles(userData: unknown): { layout: AIOStreamsProfilesLayout; profiles: AIOStreamsProfile[] } {
    const layout = profilesLayout(userData)
    if (layout === 'none') return { layout, profiles: [] }
    const data = userData as RecordValue
    if (layout === 'profiles') {
        const entries = (data.profiles as unknown[]).filter(isRecord)
        const owner = entries.find(isOwnerEntry)
        const others = entries.filter(entry => !isOwnerEntry(entry) && typeof entry.id === 'string' && entry.id)
        return { layout, profiles: [...(owner ? [normalise(owner, true)] : []), ...others.map(entry => normalise(entry, false))] }
    }
    const jellyfin = data.jellyfin as RecordValue
    const personas = Array.isArray(jellyfin.personas) ? jellyfin.personas.filter(isRecord) : []
    return {
        layout,
        profiles: [
            ...(isRecord(jellyfin.primary) ? [normalise(jellyfin.primary, true)] : []),
            ...personas.filter(entry => typeof entry.id === 'string' && entry.id && entry.id !== OWNER_PROFILE_ID).map(entry => normalise(entry, false)),
        ],
    }
}

export function readOwner(userData: unknown): { layout: AIOStreamsProfilesLayout; owner: AIOStreamsProfile | null } {
    const { layout, profiles } = listProfiles(userData)
    return { layout, owner: profiles.find(profile => profile.owner) ?? null }
}

export function ownerDisplayName(userData: unknown): string {
    const { layout, owner } = readOwner(userData)
    if (owner?.name) return owner.name
    if (layout !== 'profiles') return ''
    return isRecord(userData) && typeof userData.addonName === 'string' ? userData.addonName.trim() : ''
}

type ProfileEdit = (entry: RecordValue) => RecordValue

export function updateProfile(userData: RecordValue, id: string, edit: ProfileEdit): RecordValue {
    const next = clone(userData)
    const layout = profilesLayout(next)
    if (layout === 'profiles') {
        const profiles = next.profiles as unknown[]
        const index = profiles.findIndex(entry => isRecord(entry) && entry.id === id)
        if (index >= 0) profiles[index] = edit(profiles[index] as RecordValue)
        else if (id === OWNER_PROFILE_ID) profiles.unshift({ ...edit({ id: OWNER_PROFILE_ID }), id: OWNER_PROFILE_ID })
        else throw new Error('The selected AIOStreams user no longer exists. Load the config again.')
        return next
    }
    const jellyfin = isRecord(next.jellyfin) ? next.jellyfin : {}
    if (id === OWNER_PROFILE_ID) {
        jellyfin.primary = edit(isRecord(jellyfin.primary) ? jellyfin.primary : {})
    } else {
        const personas = Array.isArray(jellyfin.personas) ? jellyfin.personas : []
        const index = personas.findIndex(entry => isRecord(entry) && entry.id === id)
        if (index < 0) throw new Error('The selected AIOStreams user no longer exists. Load the config again.')
        personas[index] = edit(personas[index] as RecordValue)
        jellyfin.personas = personas
    }
    next.jellyfin = jellyfin
    return next
}

export function setOwnerAvatar(userData: RecordValue, avatarUrl: string | null): RecordValue {
    const remove = avatarUrl === null || avatarUrl === ''
    if (remove && profilesLayout(userData) === 'profiles' && !(userData.profiles as unknown[]).some(isOwnerEntry)) return clone(userData)
    return updateProfile(userData, OWNER_PROFILE_ID, entry => {
        const next = { ...entry }
        if (remove) delete next.avatar
        else next.avatar = avatarUrl
        return next
    })
}

export function addProfile(userData: RecordValue, profile: RecordValue & { id: string; name: string }): RecordValue {
    if (!PROFILE_ID_PATTERN.test(profile.id)) throw new Error('Choose a shorter name for this person.')
    if (!profile.name.trim() || profile.name.trim().length > 32) throw new Error('Enter a person name between 1 and 32 characters.')
    if (listProfiles(userData).profiles.some(existing => existing.id === profile.id)) throw new Error('An AIOStreams user already has this name. Select that existing user.')
    const next = clone(userData)
    const entry = clone(profile)
    if (profilesLayout(next) === 'profiles') {
        const profiles = next.profiles as unknown[]
        if (!profiles.some(isOwnerEntry)) profiles.unshift({ id: OWNER_PROFILE_ID })
        profiles.push(entry)
        return next
    }
    const jellyfin = isRecord(next.jellyfin) ? next.jellyfin : {}
    jellyfin.personas = [...(Array.isArray(jellyfin.personas) ? jellyfin.personas : []), entry]
    next.jellyfin = jellyfin
    return next
}

// Port of upstream migrateProfiles (AIOStreams packages/core/src/utils/profiles.ts); mutates config.
export function migrateLegacyProfiles(config: unknown): void {
    if (!isRecord(config)) return
    const jellyfin = config.jellyfin
    if (!isRecord(jellyfin) || (!jellyfin.primary && !jellyfin.personas)) return
    const { primary, personas, ...rest } = jellyfin
    config.jellyfin = rest
    if (config.profiles) return
    config.profiles = [
        { ...(isRecord(primary) ? primary : {}), id: OWNER_PROFILE_ID },
        ...(Array.isArray(personas) ? personas : []),
    ]
}

// Newer AIOStreams drops tracker ids that are not installed presets on every save, so they are ignored on both sides.
function dropUninstalledTrackers(config: RecordValue): void {
    if (!Array.isArray(config.profiles)) return
    const installed = new Set((Array.isArray(config.presets) ? config.presets : []).filter(isRecord).map(preset => preset.instanceId))
    for (const profile of config.profiles) {
        if (isRecord(profile) && Array.isArray(profile.trackers)) profile.trackers = profile.trackers.filter(id => installed.has(id))
    }
}

export function alignProfilesForReadback<T extends RecordValue>(planned: T, readback: T): { planned: T; readback: T } {
    if (!Array.isArray(readback.profiles)) return { planned, readback }
    const expected = clone(planned)
    const actual = clone(readback)
    migrateLegacyProfiles(expected)
    migrateLegacyProfiles(actual)
    dropUninstalledTrackers(expected)
    dropUninstalledTrackers(actual)
    for (const side of [expected, actual] as RecordValue[]) {
        if (isRecord(side.jellyfin) && Object.keys(side.jellyfin).length === 0) delete side.jellyfin
    }
    return { planned: expected, readback: actual }
}

function rawProfileEntries(userData: unknown): Map<string, string> {
    const entries = new Map<string, string>()
    if (!isRecord(userData)) return entries
    const layout = profilesLayout(userData)
    if (layout === 'profiles') {
        for (const entry of userData.profiles as unknown[]) if (isRecord(entry) && typeof entry.id === 'string') entries.set(entry.id, stableStringify(entry))
    } else if (layout === 'legacy') {
        const jellyfin = userData.jellyfin as RecordValue
        if (isRecord(jellyfin.primary)) entries.set(OWNER_PROFILE_ID, stableStringify(jellyfin.primary))
        if (Array.isArray(jellyfin.personas)) for (const entry of jellyfin.personas) if (isRecord(entry) && typeof entry.id === 'string') entries.set(entry.id, stableStringify(entry))
    }
    return entries
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    return JSON.stringify(value) ?? 'null'
}

export const PROFILE_LOSS_MESSAGE = 'This change would remove or alter another AIOStreams user, so nothing was sent. Reload and try again.'

export function assertProfilesKept(before: RecordValue, after: RecordValue, allowed: string[]): void {
    const layoutBefore = profilesLayout(before)
    const layoutAfter = profilesLayout(after)
    const layoutOk = layoutBefore === layoutAfter || (layoutBefore === 'none' && layoutAfter === 'legacy')
    if (!layoutOk) throw new Error(PROFILE_LOSS_MESSAGE)
    if (layoutAfter === 'profiles' && isRecord(after.jellyfin) && (after.jellyfin.primary !== undefined || after.jellyfin.personas !== undefined)) {
        const jellyfinBefore = isRecord(before.jellyfin) ? before.jellyfin : {}
        if (stableStringify(jellyfinBefore.primary) !== stableStringify(after.jellyfin.primary) || stableStringify(jellyfinBefore.personas) !== stableStringify(after.jellyfin.personas)) throw new Error(PROFILE_LOSS_MESSAGE)
    }
    const old = rawProfileEntries(before)
    const next = rawProfileEntries(after)
    for (const [id, value] of old) {
        if (!next.has(id)) throw new Error(PROFILE_LOSS_MESSAGE)
        if (next.get(id) !== value && !allowed.includes(id)) throw new Error(PROFILE_LOSS_MESSAGE)
    }
    for (const id of next.keys()) if (!old.has(id) && !allowed.includes(id)) throw new Error(PROFILE_LOSS_MESSAGE)
    const count = (data: RecordValue) => profilesLayout(data) === 'profiles' ? (data.profiles as unknown[]).length : -1
    if (layoutAfter === 'profiles' && count(after) < count(before)) throw new Error(PROFILE_LOSS_MESSAGE)
}

export function aiostreamsQuickAddUsers(userData: unknown): Array<{ id: string; owner: boolean; name: string }> {
    const users: Array<{ id: string; owner: boolean; name: string }> = []
    const ownerName = ownerDisplayName(userData)
    if (ownerName) users.push({ id: OWNER_PROFILE_ID, owner: true, name: ownerName.trim() })
    for (const profile of listProfiles(userData).profiles) {
        if (!profile.owner && profile.name) users.push({ id: profile.id, owner: false, name: profile.name.trim() })
    }
    return users
}
