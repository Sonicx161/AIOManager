// Persisted + synced markers for addons the user explicitly deleted, so an inbound sync (Stremio
// collection or the cloud blob) can't resurrect them. Keyed by normalized transportUrl -> deletedAt.
// Explicit Hub installs record which deletion they overrode so reinstalls converge across devices.
// A deletion remains in force until the user explicitly installs that URL again.
export type Tombstones = Record<string, number>

// Kill switch: set false to disable resurrection suppression entirely (filterResurrected becomes a
// passthrough). Tombstones are still recorded + reconciled, so flipping this back on resumes cleanly.
export const TOMBSTONES_ENABLED = true

// A stale connection or cloud snapshot may survive for weeks. Expiring a delete would let it
// reinstall the addon without a user action. The optional ttl parameter remains for callers
// that deliberately need a bounded migration window.
const DEFAULT_TTL_MS = Number.POSITIVE_INFINITY

interface AddonLike { transportUrl?: string }

// Kept byte-identical to lib/addon-url.ts normalizeAddonUrl (which mergeAddons uses). Inlined so
// this module has no relative imports and stays loadable by the node:test runner; a drift-guard
// test asserts it matches the canonical version, since a normalization mismatch would silently
// make the tombstone filter miss.
export function normUrl(url: string | undefined): string {
    if (!url) return ''
    let n = url.trim()
    n = n.replace(/^stremio:\/\//i, 'https://')
    n = n.replace(/\/manifest\.json$/i, '')
    n = n.replace(/\/+$/, '')
    return n.toLowerCase()
}

const key = (url: string | undefined) => normUrl(url)

export function addTombstones(tombstones: Tombstones | undefined, urls: Array<string | undefined>, now = Date.now(), restored?: Tombstones): Tombstones {
    const out: Tombstones = { ...(tombstones || {}) }
    for (const u of urls) {
        const k = key(u)
        // Advance past the observed delete/reinstall even when this device's
        // clock moved backwards. A fresh delete must beat an older reinstall.
        if (k) out[k] = Math.max(now, (out[k] ?? 0) + 1, (restored?.[k] ?? 0) + 1)
    }
    return out
}

// Restores acknowledge the exact deletion the user explicitly overrode. Merely
// seeing an addon (or installing it without observing a delete) is not enough to
// override a later/concurrent deletion on another device.
export function restoreAddonDeletions(deleted: Tombstones | undefined, restored: Tombstones | undefined, explicitAddons: AddonLike[]): { deletedAddons: Tombstones; restoredAddons: Tombstones } {
    const deletedAddons = { ...(deleted || {}) }
    const restoredAddons = { ...(restored || {}) }
    for (const addon of explicitAddons) {
        const k = key(addon.transportUrl)
        const deletion = deletedAddons[k]
        if (k && deletion !== undefined) {
            restoredAddons[k] = Math.max(restoredAddons[k] ?? 0, deletion)
            delete deletedAddons[k]
        }
    }
    return { deletedAddons, restoredAddons }
}

export function mergeAddonDeletionState(localDeleted: Tombstones | undefined, remoteDeleted: Tombstones | undefined, localRestored: Tombstones | undefined, remoteRestored: Tombstones | undefined): { deletedAddons: Tombstones; restoredAddons: Tombstones } {
    const deletedAddons = mergeTombstones(localDeleted, remoteDeleted)
    const restoredAddons = mergeTombstones(localRestored, remoteRestored)
    for (const [k, deletion] of Object.entries(deletedAddons)) {
        if ((restoredAddons[k] ?? -1) >= deletion) delete deletedAddons[k]
    }
    return { deletedAddons, restoredAddons }
}

// Latest-delete-wins union across two devices' blobs; expired entries dropped.
export function mergeTombstones(a: Tombstones | undefined, b: Tombstones | undefined, now = Date.now(), ttl = DEFAULT_TTL_MS): Tombstones {
    const out: Tombstones = {}
    for (const src of [a, b]) {
        for (const [k, ts] of Object.entries(src || {})) {
            if (now - ts >= ttl) continue
            if (!(k in out) || ts > out[k]) out[k] = ts
        }
    }
    return out
}

// Suppress a remote addon iff it is tombstoned AND not present locally. Local presence (an
// intentional re-add, or a disabled addon kept local) always wins, so the filter only ever
// removes a pure resurrection -- never an addon the user currently has.
export function filterResurrected<T extends AddonLike>(remote: T[], local: AddonLike[], tombstones: Tombstones | undefined, now = Date.now(), ttl = DEFAULT_TTL_MS): T[] {
    if (!TOMBSTONES_ENABLED) return remote
    if (!tombstones || Object.keys(tombstones).length === 0) return remote
    const localKeys = new Set(local.map(a => key(a.transportUrl)).filter(Boolean))
    return remote.filter(a => {
        const k = key(a.transportUrl)
        if (!k || localKeys.has(k)) return true
        const ts = tombstones[k]
        return !(ts !== undefined && now - ts < ttl)
    })
}

// After a merge, drop tombstones for any url now present (re-added/kept) and any expired ones, so
// the stored set self-heals and can never contradict the live addon list. This is the structural
// clear-on-re-add: no per-call-site checklist needed.
export function reconcileTombstones(tombstones: Tombstones | undefined, mergedAddons: AddonLike[], now = Date.now(), ttl = DEFAULT_TTL_MS): Tombstones {
    if (!tombstones) return {}
    const present = new Set(mergedAddons.map(a => key(a.transportUrl)).filter(Boolean))
    const out: Tombstones = {}
    for (const [k, ts] of Object.entries(tombstones)) {
        if (present.has(k) || now - ts >= ttl) continue
        out[k] = ts
    }
    return out
}

// Retained for compatibility with older callers. Repeated sightings of the same remote addon
// cannot establish intent: a failed platform write looks exactly like an intentional re-add.
export const AUTO_ADOPT_THRESHOLD = 3

export type ResurrectionSightings = Record<string, number>

export interface ResurrectionFilterResult<T> {
    kept: T[]
    adopted: T[]
    suppressedCount: number
    nextSightings: ResurrectionSightings
}

export function filterResurrectedAuto<T extends AddonLike>(
    remote: T[],
    local: AddonLike[],
    tombstones: Tombstones | undefined,
    sightings: ResurrectionSightings,
    now = Date.now(),
    ttl = DEFAULT_TTL_MS
): ResurrectionFilterResult<T> {
    const localKeys = new Set(local.map(a => normUrl(a.transportUrl)).filter(Boolean))
    const nextSightings: ResurrectionSightings = { ...sightings }
    const kept: T[] = []
    const adopted: T[] = []
    let suppressedCount = 0
    for (const addon of remote) {
        const k = key(addon.transportUrl)
        const tombstoned = k !== '' && tombstones?.[k] !== undefined && now - tombstones[k] < ttl
        if (!k || localKeys.has(k) || !tombstoned) { kept.push(addon); continue }
        // A read is not an explicit install, regardless of how many times it repeats.
        suppressedCount++
    }
    return { kept, adopted, suppressedCount, nextSightings }
}

const ADOPTED_STORAGE_KEY = 'aioman:adopted-tombstones'

// Persistently tracks URLs the auto-adopt has adopted, so a stale E2E blob merge
// doesn't re-create the tombstone and re-suppress an intentionally re-added addon.
export function markResurrectionAdopted(urlKey: string): void {
    try {
        if (typeof localStorage === 'undefined') return
        const raw = localStorage.getItem(ADOPTED_STORAGE_KEY)
        const adopted = raw ? JSON.parse(raw) : {}
        adopted[urlKey] = Date.now()
        localStorage.setItem(ADOPTED_STORAGE_KEY, JSON.stringify(adopted))
    } catch {}
}

export function isResurrectionAdopted(urlKey: string): boolean {
    try {
        if (typeof localStorage === 'undefined') return false
        const raw = localStorage.getItem(ADOPTED_STORAGE_KEY)
        const adopted = raw ? JSON.parse(raw) : {}
        return adopted[urlKey] !== undefined
    } catch { return false }
}

const SIGHTINGS_STORAGE_KEY = 'aioman:tombstone-sightings'

export function loadResurrectionSightings(): ResurrectionSightings {
    try {
        if (typeof localStorage === 'undefined') return {}
        const raw = localStorage.getItem(SIGHTINGS_STORAGE_KEY)
        return raw ? JSON.parse(raw) : {}
    } catch { return {} }
}

export function saveResurrectionSightings(s: ResurrectionSightings): void {
    try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(SIGHTINGS_STORAGE_KEY, JSON.stringify(s))
    } catch {}
}
