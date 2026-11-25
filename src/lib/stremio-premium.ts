export type StremioPlanFeature = 'profiles' | 'catalogWeights' | 'streamPresets' | 'downloads'

export interface StremioPlan {
    features: Partial<Record<StremioPlanFeature, boolean>>
    memberSince: number | null
}

export interface PremiumStatus {
    active: boolean
    lifetime: boolean
    expiresAt: number | null
    plan?: StremioPlan
}

export interface StremioPlanRow {
    label: string
    value: string
    muted: boolean
}

const LIFETIME_YEAR = 2099
const EARLIEST_MEMBER_SINCE = Date.UTC(2000, 0, 1)

const INACTIVE: PremiumStatus = { active: false, lifetime: false, expiresAt: null }

const PLAN_FEATURES: ReadonlyArray<{ key: StremioPlanFeature; label: string }> = [
    { key: 'profiles', label: 'Profiles' },
    { key: 'catalogWeights', label: 'Catalog weights' },
    { key: 'streamPresets', label: 'Stream presets' },
    { key: 'downloads', label: 'Downloads' },
]

export function parsePremiumExpire(raw: unknown, now: number = Date.now()): PremiumStatus {
    if (typeof raw !== 'string') return INACTIVE
    const expiresAt = Date.parse(raw)
    if (Number.isNaN(expiresAt) || expiresAt <= now) return INACTIVE
    const lifetime = new Date(expiresAt).getUTCFullYear() >= LIFETIME_YEAR
    return { active: true, lifetime, expiresAt }
}

// Stremio sends profiles as a count (a free login answers 1, its own main profile) and the rest as booleans.
function featureIncluded(key: StremioPlanFeature, value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return key === 'profiles' ? value > 1 : value > 0
    return undefined
}

export function parseStremioPlan(user: { features?: unknown; dateRegistered?: unknown } | null | undefined, now: number = Date.now()): StremioPlan {
    const features: StremioPlan['features'] = {}
    const raw = user?.features
    if (raw && typeof raw === 'object') {
        for (const { key } of PLAN_FEATURES) {
            const included = featureIncluded(key, (raw as Record<string, unknown>)[key])
            if (included !== undefined) features[key] = included
        }
    }
    const registered = typeof user?.dateRegistered === 'string' ? Date.parse(user.dateRegistered) : Number.NaN
    const memberSince = Number.isFinite(registered) && registered >= EARLIEST_MEMBER_SINCE && registered <= now ? registered : null
    return { features, memberSince }
}

export function parseStremioMembership(user: { premium_expire?: unknown; features?: unknown; dateRegistered?: unknown } | null | undefined, now: number = Date.now()): PremiumStatus {
    return { ...parsePremiumExpire(user?.premium_expire, now), plan: parseStremioPlan(user, now) }
}

export function stremioPlanRows(plan: StremioPlan | undefined, formatMonth: (ts: number) => string): StremioPlanRow[] {
    if (!plan) return []
    const rows: StremioPlanRow[] = []
    const known = PLAN_FEATURES.filter(f => plan.features[f.key] !== undefined)
    if (known.length === PLAN_FEATURES.length) {
        const included = known.filter(f => plan.features[f.key]).length
        rows.push({ label: 'Plan features', value: `${included} of ${PLAN_FEATURES.length}`, muted: included === 0 })
    }
    for (const f of known) {
        const included = plan.features[f.key] === true
        rows.push({ label: f.label, value: included ? 'Included' : 'Not included', muted: !included })
    }
    if (plan.memberSince != null) rows.push({ label: 'Member since', value: formatMonth(plan.memberSince), muted: false })
    return rows
}
