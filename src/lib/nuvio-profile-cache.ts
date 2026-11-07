export type NuvioProfileRows = Array<Record<string, unknown>>

const profileCache = new Map<string, NuvioProfileRows | Promise<NuvioProfileRows>>()
let cacheGeneration = 0
const MAX_PROFILE_CACHE_ENTRIES = 32

function setProfileCache(key: string, value: NuvioProfileRows | Promise<NuvioProfileRows>) {
    profileCache.set(key, value)
    while (profileCache.size > MAX_PROFILE_CACHE_ENTRIES) {
        const oldest = profileCache.keys().next().value
        if (oldest === undefined) break
        profileCache.delete(oldest)
    }
}

export function getNuvioProfiles(accessToken: string, load: () => Promise<unknown>): Promise<NuvioProfileRows> {
    const cached = profileCache.get(accessToken)
    if (cached) return Promise.resolve(cached)
    const generation = cacheGeneration
    const pending = load().then((value) => {
        if (!Array.isArray(value) || !value.every(row => typeof row === 'object' && row !== null && !Array.isArray(row))) {
            throw new Error('Nuvio profiles returned an unexpected response shape')
        }
        const profiles = value as NuvioProfileRows
        if (generation === cacheGeneration) setProfileCache(accessToken, profiles)
        return profiles
    }).catch((error) => {
        if (profileCache.get(accessToken) === pending) profileCache.delete(accessToken)
        throw error
    })
    setProfileCache(accessToken, pending)
    return pending
}

export function invalidateNuvioProfileCache() {
    cacheGeneration += 1
    profileCache.clear()
}
